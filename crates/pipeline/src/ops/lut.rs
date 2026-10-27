//! Lookup tables that keep the per-pixel stage cheap.

use crate::image::Rgb;

/// A 1D lookup table indexed by the top bits of an `f32`: exponent plus the leading
/// mantissa bits. That is (piecewise linearly) log-spaced, with `2^(23 - shift)`
/// buckets per stop, and costs no float math to index.
pub struct BitsLut<T> {
    shift: u32,
    min: f32,
    min_key: u32,
    table: Vec<T>,
}

impl<T: Copy> BitsLut<T> {
    pub fn new(min: f32, max: f32, shift: u32, f: impl Fn(f32) -> T) -> Self {
        let (min_key, max_key) = (min.to_bits() >> shift, max.to_bits() >> shift);
        let half_bucket = 1u32 << (shift - 1);
        Self {
            shift,
            min,
            min_key,
            // Sample each bucket at its midpoint.
            table: (min_key..=max_key).map(|k| f(f32::from_bits((k << shift) | half_bucket))).collect(),
        }
    }

    #[inline]
    pub fn eval(&self, x: f32) -> T {
        // `max` also maps negatives and NaN to the first bucket.
        let key = (x.max(self.min).to_bits() >> self.shift) - self.min_key;
        self.table[(key as usize).min(self.table.len() - 1)]
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.table.len()
    }
}

/// 256 buckets per stop.
pub const FINE: u32 = 15;
/// Darkest value the curves distinguish from black (2⁻²⁴).
pub const FLOOR: f32 = 5.960_464_5e-8;
/// Brightest value the curves distinguish (2¹⁶ — way past any highlight).
pub const CEILING: f32 = 65536.0;

/// log₂ for positive normal floats: exponent + quintic on the mantissa (|error| < 3e-5).
#[inline]
pub fn log2_fast(x: f32) -> f32 {
    let bits = x.to_bits();
    let exponent = ((bits >> 23) & 0xff) as i32 - 127;
    let m = f32::from_bits((bits & 0x007f_ffff) | 0x3f80_0000) - 1.0;
    let poly = m * (1.441_825_5 + m * (-0.708_678_9 + m * (0.415_411_2 + m * (-0.194_408_3 + m * 0.045_878_95))));
    exponent as f32 + poly
}

/// A 3D lookup table over log-encoded RGB, tetrahedrally interpolated. Outputs
/// must lie in [0, 1]; they are stored as 16-bit integers (1.6 MB for 65³).
pub struct Lut3d {
    size: usize,
    /// log₂ range covered on each axis.
    lo: f32,
    scale: f32,
    data: Vec<[u16; 3]>,
}

impl Lut3d {
    /// Sample `f` on a `size³` grid spanning `[2^lo, 2^hi]` per channel.
    pub fn new(size: usize, lo: f32, hi: f32, f: impl Fn(Rgb) -> Rgb) -> Self {
        let node = |i: usize| (lo + (hi - lo) * i as f32 / (size - 1) as f32).exp2();
        let mut data = Vec::with_capacity(size * size * size);
        for r in 0..size {
            for g in 0..size {
                for b in 0..size {
                    data.push(f([node(r), node(g), node(b)]).map(|v| (v.clamp(0.0, 1.0) * 65535.0 + 0.5) as u16));
                }
            }
        }
        Self { size, lo, scale: (size - 1) as f32 / (hi - lo), data }
    }

    /// Upper bound (linear) of the covered range.
    pub fn max_input(&self) -> f32 {
        (self.lo + (self.size - 1) as f32 / self.scale).exp2()
    }

    #[inline]
    pub fn eval(&self, rgb: Rgb) -> Rgb {
        let last = (self.size - 1) as f32;
        let coord = rgb.map(|v| ((log2_fast(v.max(1e-30)) - self.lo) * self.scale).clamp(0.0, last));
        let base = coord.map(|c| (c as usize).min(self.size - 2));
        let [fx, fy, fz] = std::array::from_fn(|i| coord[i] - base[i] as f32);
        let n = self.size;
        let at = |dr: usize, dg: usize, db: usize| {
            self.data[((base[0] + dr) * n + base[1] + dg) * n + base[2] + db].map(|v| v as f32 * (1.0 / 65535.0))
        };
        let lerp3 = |a: Rgb, b: Rgb, t: f32| [(b[0] - a[0]) * t, (b[1] - a[1]) * t, (b[2] - a[2]) * t];
        let add = |a: Rgb, b: Rgb| [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

        let c000 = at(0, 0, 0);
        let c111 = at(1, 1, 1);
        // Pick the tetrahedron containing the point and interpolate along its edges.
        let (p1, p2, t1, t2, t3) = if fx >= fy {
            if fy >= fz {
                (at(1, 0, 0), at(1, 1, 0), fx, fy, fz)
            } else if fx >= fz {
                (at(1, 0, 0), at(1, 0, 1), fx, fz, fy)
            } else {
                (at(0, 0, 1), at(1, 0, 1), fz, fx, fy)
            }
        } else if fz >= fy {
            (at(0, 0, 1), at(0, 1, 1), fz, fy, fx)
        } else if fz >= fx {
            (at(0, 1, 0), at(0, 1, 1), fy, fz, fx)
        } else {
            (at(0, 1, 0), at(1, 1, 0), fy, fx, fz)
        };
        add(add(add(c000, lerp3(c000, p1, t1)), lerp3(p1, p2, t2)), lerp3(p2, c111, t3))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log2_fast_is_accurate() {
        for x in [1e-7f32, 0.001, 0.18, 0.5, 1.0, 1.7, 3.0, 1000.0] {
            assert!((log2_fast(x) - x.log2()).abs() < 5e-5, "{x}");
        }
    }

    #[test]
    fn lut3d_reproduces_affine_functions() {
        // Tetrahedral interpolation is exact for functions affine in the grid coordinates.
        let f = |c: Rgb| c.map(|v| v.log2());
        // Map log₂ ∈ [-8, 4] affinely into [0, 1] outputs.
        let g = |c: Rgb| { let l = f(c).map(|v| (v + 8.0) / 12.0); [(l[0] + 2.0 * l[1]) / 3.0, l[2], (l[0] + 1.0 - l[2]) / 2.0] };
        let lut = Lut3d::new(9, -8.0, 4.0, g);
        for rgb in [[0.01f32, 0.2, 3.0], [0.5, 0.5, 0.5], [0.004, 9.0, 0.1]] {
            let want = g(rgb);
            let got = lut.eval(rgb);
            assert!(got.iter().zip(want).all(|(a, b)| (a - b).abs() < 1e-3), "{rgb:?}: {got:?} vs {want:?}");
        }
    }

    #[test]
    fn bits_lut_is_log_spaced_and_safe() {
        let lut = BitsLut::new(FLOOR, CEILING, FINE, |x| x);
        assert_eq!(lut.len(), 40 * 256 + 1);
        for x in [1e-6f32, 0.001, 0.18, 1.0, 3.3, 1000.0] {
            assert!((lut.eval(x) / x - 1.0).abs() < 0.003, "{x}");
        }
        assert_eq!(lut.eval(-1.0), lut.eval(0.0));
        assert_eq!(lut.eval(f32::NAN), lut.eval(0.0));
    }
}
