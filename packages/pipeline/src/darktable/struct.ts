/**
 * Reading darktable's module parameters: each history entry stores the module's C
 * parameter struct (`dt_iop_<module>_params_t`) as raw bytes, as compiled for x86-64
 * and arm64 (little-endian, natural alignment). A `Layout` describes one struct version
 * field by field, as upstream declares it, and reads it from the bytes.
 */

/** A field's C type: `int`/enums and `gboolean` are 4-byte ints; `bool` is one byte. */
export type FieldType =
  | 'f32'
  | 'f64'
  | 'i32'
  | 'u32'
  | 'i16'
  | 'u16'
  | 'u8'
  /** `gboolean` (an int). */
  | 'gboolean'
  /** C `bool` / `gboolean` stored as `uint8_t`. */
  | 'bool'
  /** `char name[n]`: a NUL-terminated string, read as UTF-8. */
  | { char: number }
  /** `type name[n]`, or nested arrays (`float x[3][2]` is `{ array: { array: 'f32', n: 2 }, n: 3 }`). */
  | { array: FieldType; n: number }
  /** A nested struct. */
  | { struct: Layout };

export type Field = readonly [name: string, type: FieldType];

interface Placed {
  name: string;
  type: FieldType;
  offset: number;
}

/** Size and alignment of a field type. */
function measure(type: FieldType): { size: number; align: number } {
  if (typeof type === 'string') {
    const size = { f32: 4, f64: 8, i32: 4, u32: 4, i16: 2, u16: 2, u8: 1, gboolean: 4, bool: 1 }[type];
    return { size, align: size };
  }
  if ('char' in type) return { size: type.char, align: 1 };
  if ('array' in type) {
    const inner = measure(type.array);
    return { size: inner.size * type.n, align: inner.align };
  }
  return { size: type.struct.size, align: type.struct.align };
}

/** A C struct's layout: fields at their offsets, padded to its alignment. */
export class Layout {
  readonly fields: readonly Placed[];
  readonly size: number;
  readonly align: number;

  constructor(fields: readonly Field[]) {
    let offset = 0;
    let align = 1;
    const placed: Placed[] = [];
    for (const [name, type] of fields) {
      const m = measure(type);
      offset = Math.ceil(offset / m.align) * m.align;
      placed.push({ name, type, offset });
      offset += m.size;
      align = Math.max(align, m.align);
    }
    this.fields = placed;
    this.align = align;
    this.size = Math.ceil(offset / align) * align;
  }

  /** The struct's fields, or null if `bytes` isn't its size (another version, or damaged). */
  read(bytes: Uint8Array): Record<string, unknown> | null {
    if (bytes.length !== this.size) return null;
    return this.readAt(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0);
  }

  /** The struct's fields, read at `offset` in `view`. */
  readAt(view: DataView, offset: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of this.fields) out[f.name] = readField(view, offset + f.offset, f.type);
    return out;
  }
}

const utf8 = new TextDecoder('utf-8');

function readField(view: DataView, at: number, type: FieldType): unknown {
  if (typeof type === 'string') {
    switch (type) {
      case 'f32':
        return view.getFloat32(at, true);
      case 'f64':
        return view.getFloat64(at, true);
      case 'i32':
        return view.getInt32(at, true);
      case 'u32':
        return view.getUint32(at, true);
      case 'i16':
        return view.getInt16(at, true);
      case 'u16':
        return view.getUint16(at, true);
      case 'u8':
        return view.getUint8(at);
      case 'gboolean':
        return view.getInt32(at, true) !== 0;
      case 'bool':
        return view.getUint8(at) !== 0;
    }
  }
  if ('char' in type) {
    const bytes = new Uint8Array(view.buffer, view.byteOffset + at, type.char);
    const end = bytes.indexOf(0);
    return utf8.decode(end < 0 ? bytes : bytes.subarray(0, end));
  }
  if ('array' in type) {
    const step = measure(type.array).size;
    return Array.from({ length: type.n }, (_, i) => readField(view, at + i * step, type.array));
  }
  return type.struct.readAt(view, at);
}

/**
 * Bytes of a struct with these values (the inverse of `read`: for tests and fixtures).
 * Missing fields are zero.
 */
export function writeStruct(layout: Layout, values: Record<string, unknown>): Uint8Array {
  const bytes = new Uint8Array(layout.size);
  writeAt(new DataView(bytes.buffer), 0, layout, values);
  return bytes;
}

function writeAt(view: DataView, offset: number, layout: Layout, values: Record<string, unknown>) {
  for (const f of layout.fields) {
    if (values[f.name] !== undefined) writeField(view, offset + f.offset, f.type, values[f.name]);
  }
}

function writeField(view: DataView, at: number, type: FieldType, value: unknown) {
  if (typeof type === 'string') {
    const n = Number(value);
    switch (type) {
      case 'f32':
        return view.setFloat32(at, n, true);
      case 'f64':
        return view.setFloat64(at, n, true);
      case 'i32':
      case 'gboolean':
        return view.setInt32(at, n, true);
      case 'u32':
        return view.setUint32(at, n, true);
      case 'i16':
        return view.setInt16(at, n, true);
      case 'u16':
        return view.setUint16(at, n, true);
      case 'u8':
      case 'bool':
        return view.setUint8(at, n);
    }
  }
  if ('char' in type) {
    const encoded = new TextEncoder().encode(String(value)).subarray(0, type.char - 1);
    new Uint8Array(view.buffer, view.byteOffset + at, type.char).set(encoded);
    return;
  }
  if ('array' in type) {
    const step = measure(type.array).size;
    (value as unknown[]).forEach((v, i) => writeField(view, at + i * step, type.array, v));
    return;
  }
  writeAt(view, at, type.struct, value as Record<string, unknown>);
}
