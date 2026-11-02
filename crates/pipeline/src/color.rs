//! Colour science helpers: matrices, luminance and transfer functions.

use crate::image::Rgb;

pub type Mat3 = [[f32; 3]; 3];

pub const IDENTITY: Mat3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

/// Linear Rec.709/sRGB (D65) → CIE XYZ.
pub const XYZ_FROM_REC709: Mat3 = [
    [0.412_456_4, 0.357_576_1, 0.180_437_5],
    [0.212_672_9, 0.715_152_2, 0.072_175_0],
    [0.019_333_9, 0.119_192_0, 0.950_304_1],
];

/// CIE XYZ → linear Rec.709/sRGB (D65).
pub const REC709_FROM_XYZ: Mat3 = [
    [3.240_454_2, -1.537_138_5, -0.498_531_4],
    [-0.969_266_0, 1.876_010_8, 0.041_556_0],
    [0.055_643_4, -0.204_025_9, 1.057_225_2],
];

/// Linear Rec.709 → linear Rec.2020 (both D65).
pub const REC2020_FROM_REC709: Mat3 = [
    [0.627_403_9, 0.329_283_0, 0.043_313_1],
    [0.069_097_3, 0.919_540_4, 0.011_362_3],
    [0.016_391_4, 0.088_013_3, 0.895_595_3],
];

/// Linear Rec.2020 → linear Rec.709.
pub const REC709_FROM_REC2020: Mat3 = [
    [1.660_491_0, -0.587_641_1, -0.072_849_9],
    [-0.124_550_5, 1.132_899_9, -0.008_349_4],
    [-0.018_150_8, -0.100_578_9, 1.118_729_7],
];

/// Rec.2020 luminance weights (the working space).
pub const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

/// Middle grey, in scene-linear terms.
pub const MIDDLE_GREY: f32 = 0.1845;

#[inline]
pub fn luminance(p: Rgb) -> f32 {
    p[0] * LUMA_REC2020[0] + p[1] * LUMA_REC2020[1] + p[2] * LUMA_REC2020[2]
}

#[inline]
pub fn mul_vec(m: &Mat3, v: Rgb) -> Rgb {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

pub fn mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut out = [[0.0; 3]; 3];
    for (i, row) in out.iter_mut().enumerate() {
        for (j, cell) in row.iter_mut().enumerate() {
            *cell = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    out
}

pub fn invert(m: &Mat3) -> Option<Mat3> {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if det.abs() < 1e-12 || !det.is_finite() {
        return None;
    }
    let inv_det = 1.0 / det;
    Some([
        [
            (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * inv_det,
            (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * inv_det,
            (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * inv_det,
        ],
        [
            (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * inv_det,
            (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * inv_det,
            (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * inv_det,
        ],
        [
            (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * inv_det,
            (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * inv_det,
            (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * inv_det,
        ],
    ])
}

/// Linear Rec.2020 → CIE XYZ (D65).
pub fn xyz_from_rec2020() -> Mat3 {
    mul(&XYZ_FROM_REC709, &REC709_FROM_REC2020)
}

/// CIE XYZ → linear Rec.2020.
pub fn rec2020_from_xyz() -> Mat3 {
    invert(&xyz_from_rec2020()).expect("invertible")
}

/// XYZ of the working space's white (D65), with Y = 1.
pub fn white_xyz() -> Rgb {
    mul_vec(&XYZ_FROM_REC709, [1.0; 3])
}

/// CIE 1931 xy chromaticity of the working space's white (D65).
pub fn white_xy() -> [f32; 2] {
    xy(white_xyz())
}

/// CIE 1931 xy chromaticity of an XYZ colour.
pub fn xy(xyz: Rgb) -> [f32; 2] {
    let sum = xyz[0] + xyz[1] + xyz[2];
    [xyz[0] / sum, xyz[1] / sum]
}

/// The camera's response to D65 white light, from its XYZ → camera matrix: the rows
/// of `camera ← Rec.709`. `None` for a degenerate matrix.
fn camera_d65(xyz_to_cam: &[[f32; 3]; 4]) -> Option<(Mat3, Rgb)> {
    let cam_xyz: Mat3 = [xyz_to_cam[0], xyz_to_cam[1], xyz_to_cam[2]];
    let cam_from_709 = mul(&cam_xyz, &XYZ_FROM_REC709);
    let response = cam_from_709.map(|row| row.iter().sum::<f32>());
    response.iter().all(|s| s.abs() >= 1e-9 && s.is_finite()).then_some((cam_from_709, response))
}

/// Build the camera RGB → working space (linear Rec.2020) matrix from the camera's
/// XYZ → camera matrix, the same way dcraw does: rows are normalised so that a
/// white-balanced neutral in camera space maps to a neutral in the output space.
pub fn working_from_camera(xyz_to_cam: &[[f32; 3]; 4]) -> Mat3 {
    let Some((mut cam_from_709, response)) = camera_d65(xyz_to_cam) else {
        return REC2020_FROM_REC709;
    };
    for (row, sum) in cam_from_709.iter_mut().zip(response) {
        for v in row.iter_mut() {
            *v /= sum;
        }
    }
    match invert(&cam_from_709) {
        Some(rec709_from_cam) => mul(&REC2020_FROM_REC709, &rec709_from_cam),
        None => REC2020_FROM_REC709,
    }
}

/// The "camera reference" white balance (darktable's): multipliers, normalised to
/// green = 1, that make D65 white light neutral. `None` for a degenerate matrix.
pub fn reference_wb(xyz_to_cam: &[[f32; 3]; 4]) -> Option<[f32; 3]> {
    let (_, response) = camera_d65(xyz_to_cam)?;
    let wb = response.map(|r| response[1] / r);
    wb.iter().all(|v| v.is_finite() && *v > 0.0).then_some(wb)
}

/// The xy chromaticity of the light that white balance multipliers `wb` make neutral,
/// in the working space (where D65 is white): the as-shot illuminant. darktable's
/// `WB_coeffs_to_illuminant_xy`, without its adaptation to a D50 pipeline.
pub fn illuminant_of_wb(xyz_to_cam: &[[f32; 3]; 4], wb: [f32; 3]) -> Option<[f32; 2]> {
    let reference = reference_wb(xyz_to_cam)?;
    // A neutral under that light reads 1/wb in camera RGB.
    let rgb = mul_vec(&working_from_camera(xyz_to_cam), [0, 1, 2].map(|c| reference[c] / wb[c]));
    let xy = xy(mul_vec(&xyz_from_rec2020(), rgb));
    xy.iter().all(|v| v.is_finite() && *v > 0.0).then_some(xy)
}

/// sRGB opto-electronic transfer function (linear → encoded), input clamped to [0, 1].
#[inline]
pub fn srgb_oetf(v: f32) -> f32 {
    let v = v.clamp(0.0, 1.0);
    if v <= 0.003_130_8 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rec2020_roundtrip() {
        let m = mul(&REC709_FROM_REC2020, &REC2020_FROM_REC709);
        for i in 0..3 {
            for j in 0..3 {
                let expected = if i == j { 1.0 } else { 0.0 };
                assert!((m[i][j] - expected).abs() < 1e-4, "{m:?}");
            }
        }
    }

    /// Sony ILCE-7RM5 (Adobe DNG converter).
    const A7RM5: [[f32; 3]; 4] = [
        [0.8200, -0.2976, -0.0719],
        [-0.4296, 1.2053, 0.2532],
        [-0.0429, 0.1282, 0.5774],
        [0.0, 0.0, 0.0],
    ];

    #[test]
    fn reference_wb_is_d65() {
        let wb = reference_wb(&A7RM5).unwrap();
        assert_eq!(wb[1], 1.0);
        let xy = illuminant_of_wb(&A7RM5, wb).unwrap();
        let white = white_xy();
        assert!((xy[0] - white[0]).abs() < 1e-5 && (xy[1] - white[1]).abs() < 1e-5, "{xy:?}");
        assert!((white[0] - 0.3127).abs() < 1e-4 && (white[1] - 0.3290).abs() < 1e-4, "{white:?}");
        // More red gain: the light was bluer than D65.
        let cool = illuminant_of_wb(&A7RM5, [wb[0] * 1.3, 1.0, wb[2] * 0.8]).unwrap();
        assert!(cool[0] < xy[0] && cool[1] < xy[1], "{cool:?}");
    }

    #[test]
    fn camera_matrix_preserves_neutral() {
        // Some plausible camera matrix (Sony ILCE-7RM5 from Adobe DNG converter).
        let xyz_to_cam = [
            [0.8200, -0.2976, -0.0719],
            [-0.4296, 1.2053, 0.2532],
            [-0.0429, 0.1282, 0.5774],
            [0.0, 0.0, 0.0],
        ];
        let m = working_from_camera(&xyz_to_cam);
        let white = mul_vec(&m, [1.0, 1.0, 1.0]);
        for c in white {
            assert!((c - 1.0).abs() < 1e-4, "{white:?}");
        }
    }
}
