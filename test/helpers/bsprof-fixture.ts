/** A tiny but format-valid .bsprof (header + one string + one root path element); no device needed. */

function varint(value: number | bigint): number[] {
  let v = BigInt(value);
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) byte |= 0x80;
    out.push(byte);
  } while (v !== 0n);
  return out;
}

function utf8z(s: string): number[] {
  return [...Buffer.from(s, 'utf8'), 0];
}

function float32(n: number): number[] {
  const b = Buffer.alloc(4);
  b.writeFloatLE(n, 0);
  return [...b];
}

export function buildBsprof(): Buffer {
  // Body after the header: a string-table entry (type 0) and a root path element (type 2).
  // tag for string id 1: (1<<3)|0 = 8 ; then utf8z payload.
  const body: number[] = [
    ...varint(8), ...utf8z('main.brs'),
    // path element id 1, type 2: tag (1<<3)|2 = 10; callingId=0 (root); modId, fileStrId, lineNumber, funcStrId
    ...varint(10), ...varint(0), ...varint(0), ...varint(1), ...varint(1), ...varint(1),
  ];

  // Header fields in parse order, AFTER the 8-byte magic+padding.
  const headerFields: number[] = [
    ...varint(3), ...varint(0), ...varint(0), // major.minor.patch
  ];
  // headerSize is a varint we must back-patch; reserve a fixed 1-byte slot (header < 128 bytes).
  const afterHeaderSize: number[] = [
    ...float32(1.0), ...float32(1.0), // requested/actual sample ratio
    ...varint(1), ...varint(1), // lineSpecificData, memoryOperations (truthy)
    ...varint(0), // timestampStart (vi64)
    ...utf8z('TestApp (dev)'), // targetName
    ...utf8z(''), // supplementalInfo
    ...utf8z('9.9.9999'), // targetVersion
    ...utf8z('Roku'), // deviceVendor
    ...utf8z('TestModel'), // deviceModel
    ...utf8z('TST.000'), // deviceFirmware
  ];

  const magic = [...Buffer.from('bsprof', 'ascii'), 0, 0]; // 6 + 2 padding = offset 8
  // headerSize = total bytes from start of file up to (and including) the header,
  // i.e. where the body begins. Slot is 1 byte, so headerSize occupies index after headerFields.
  const headerSize = magic.length + headerFields.length + 1 + afterHeaderSize.length;
  if (headerSize >= 128) throw new Error('header must fit in a single-byte varint for this fixture');

  return Buffer.from([
    ...magic,
    ...headerFields,
    headerSize, // single-byte varint
    ...afterHeaderSize,
    ...body,
  ]);
}
