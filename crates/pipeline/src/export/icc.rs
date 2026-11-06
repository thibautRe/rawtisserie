//! ICC profiles for the output colour spaces, generated rather than bundled: version 2
//! matrix/TRC display profiles (the most widely supported kind), with the primaries
//! adapted to the D50 profile connection space with Bradford, like the usual ones.

use crate::output::ColorSpace;

/// The ICC profile connection space's white (D50), as the spec rounds it.
const D50: [f64; 3] = [0.9642, 1.0, 0.8249];

const BRADFORD: [[f64; 3]; 3] = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];

/// Entries of the sampled tone curves (sRGB, Rec.2020 transfer functions).
const CURVE_POINTS: usize = 1024;

fn mul3(a: &[[f64; 3]; 3], b: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    std::array::from_fn(|i| std::array::from_fn(|j| (0..3).map(|k| a[i][k] * b[k][j]).sum()))
}

fn mul_vec3(m: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|i| (0..3).map(|k| m[i][k] * v[k]).sum())
}

fn invert3(m: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    let c = |r0: usize, r1: usize, c0: usize, c1: usize| m[r0][c0] * m[r1][c1] - m[r0][c1] * m[r1][c0];
    [
        [c(1, 2, 1, 2) / det, -c(0, 2, 1, 2) / det, c(0, 1, 1, 2) / det],
        [-c(1, 2, 0, 2) / det, c(0, 2, 0, 2) / det, -c(0, 1, 0, 2) / det],
        [c(1, 2, 0, 1) / det, -c(0, 2, 0, 1) / det, c(0, 1, 0, 1) / det],
    ]
}

/// The space's RGB → XYZ, chromatically adapted from its white (D65) to D50.
pub fn d50_matrix(space: ColorSpace) -> [[f64; 3]; 3] {
    let m = space.xyz_from_rgb().map(|row| row.map(f64::from));
    let white = mul_vec3(&m, [1.0; 3]);
    let (src, dst) = (mul_vec3(&BRADFORD, white), mul_vec3(&BRADFORD, D50));
    let scale = [[dst[0] / src[0], 0.0, 0.0], [0.0, dst[1] / src[1], 0.0], [0.0, 0.0, dst[2] / src[2]]];
    let adapt = mul3(&invert3(&BRADFORD), &mul3(&scale, &BRADFORD));
    mul3(&adapt, &m)
}

fn s15_fixed16(v: f64) -> [u8; 4] {
    ((v * 65536.0).round() as i32).to_be_bytes()
}

fn xyz_tag(xyz: [f64; 3]) -> Vec<u8> {
    let mut t = b"XYZ \0\0\0\0".to_vec();
    xyz.iter().for_each(|&v| t.extend_from_slice(&s15_fixed16(v)));
    t
}

fn curve_tag(space: ColorSpace) -> Vec<u8> {
    let mut t = b"curv\0\0\0\0".to_vec();
    match space.gamma() {
        Some(gamma) => {
            // u8Fixed8: Adobe RGB's 563/256 is exact.
            t.extend_from_slice(&1u32.to_be_bytes());
            t.extend_from_slice(&((f64::from(gamma) * 256.0).round() as u16).to_be_bytes());
        }
        None => {
            t.extend_from_slice(&(CURVE_POINTS as u32).to_be_bytes());
            for i in 0..CURVE_POINTS {
                let v = f64::from(space.eotf(i as f32 / (CURVE_POINTS - 1) as f32));
                t.extend_from_slice(&((v * 65535.0).round() as u16).to_be_bytes());
            }
        }
    }
    t
}

/// `textDescriptionType`: ASCII, with empty Unicode and ScriptCode parts.
fn description_tag(text: &str) -> Vec<u8> {
    let mut t = b"desc\0\0\0\0".to_vec();
    t.extend_from_slice(&(text.len() as u32 + 1).to_be_bytes());
    t.extend_from_slice(text.as_bytes());
    t.push(0);
    t.extend_from_slice(&[0; 4 + 4 + 2 + 1 + 67]);
    t
}

fn text_tag(text: &str) -> Vec<u8> {
    let mut t = b"text\0\0\0\0".to_vec();
    t.extend_from_slice(text.as_bytes());
    t.push(0);
    t
}

/// The ICC profile of `space`.
pub fn profile(space: ColorSpace) -> Vec<u8> {
    let m = d50_matrix(space);
    let column = |c: usize| [m[0][c], m[1][c], m[2][c]];
    let curve = curve_tag(space);
    // The three channels share one curve.
    let tags: [(&[u8; 4], Vec<u8>); 9] = [
        (b"desc", description_tag(space.name())),
        (b"cprt", text_tag("No copyright, use freely")),
        (b"wtpt", xyz_tag(D50)),
        (b"rXYZ", xyz_tag(column(0))),
        (b"gXYZ", xyz_tag(column(1))),
        (b"bXYZ", xyz_tag(column(2))),
        (b"rTRC", curve),
        (b"gTRC", Vec::new()),
        (b"bTRC", Vec::new()),
    ];

    let table_end = 128 + 4 + 12 * tags.len();
    let mut data = Vec::new();
    let mut table = (tags.len() as u32).to_be_bytes().to_vec();
    let mut last = (0, 0);
    for (signature, bytes) in &tags {
        if !bytes.is_empty() {
            while data.len() % 4 != 0 {
                data.push(0);
            }
            last = (table_end + data.len(), bytes.len());
            data.extend_from_slice(bytes);
        }
        table.extend_from_slice(*signature);
        table.extend_from_slice(&(last.0 as u32).to_be_bytes());
        table.extend_from_slice(&(last.1 as u32).to_be_bytes());
    }
    while data.len() % 4 != 0 {
        data.push(0);
    }

    let size = table_end + data.len();
    let mut header = Vec::with_capacity(128);
    header.extend_from_slice(&(size as u32).to_be_bytes());
    header.extend_from_slice(&[0; 4]); // preferred CMM
    header.extend_from_slice(&[2, 0x10, 0, 0]); // version 2.1
    header.extend_from_slice(b"mntrRGB XYZ ");
    for v in [2026u16, 1, 1, 0, 0, 0] {
        header.extend_from_slice(&v.to_be_bytes());
    }
    header.extend_from_slice(b"acsp");
    header.extend_from_slice(&[0; 4 + 4 + 4 + 4 + 8]); // platform, flags, manufacturer, model, attributes
    header.extend_from_slice(&0u32.to_be_bytes()); // perceptual intent
    D50.iter().for_each(|&v| header.extend_from_slice(&s15_fixed16(v)));
    header.extend_from_slice(&[0; 4]); // creator
    header.resize(128, 0);

    let mut out = header;
    out.extend_from_slice(&table);
    out.extend_from_slice(&data);
    debug_assert_eq!(out.len(), size);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srgb_primaries_match_the_standard_profile() {
        // sRGB IEC61966-2.1's colorants, as most profiles round them.
        let m = d50_matrix(ColorSpace::Srgb);
        let expected = [[0.4361, 0.3851, 0.1431], [0.2225, 0.7169, 0.0606], [0.0139, 0.0971, 0.7141]];
        for (row, want) in m.iter().zip(expected) {
            for (v, w) in row.iter().zip(want) {
                assert!((v - w).abs() < 5e-4, "{m:?}");
            }
        }
    }

    #[test]
    fn profiles_are_well_formed() {
        for space in ColorSpace::ALL {
            let p = profile(space);
            assert_eq!(u32::from_be_bytes(p[..4].try_into().unwrap()) as usize, p.len());
            assert_eq!(&p[36..40], b"acsp");
            assert_eq!(p.len() % 4, 0);
            let count = u32::from_be_bytes(p[128..132].try_into().unwrap()) as usize;
            for i in 0..count {
                let e = 132 + 12 * i;
                let at = u32::from_be_bytes(p[e + 4..e + 8].try_into().unwrap()) as usize;
                let len = u32::from_be_bytes(p[e + 8..e + 12].try_into().unwrap()) as usize;
                assert!(at % 4 == 0 && at + len <= p.len(), "{space:?} tag {i}");
            }
        }
    }
}
