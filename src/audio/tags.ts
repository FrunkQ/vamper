// Vendored from Gondryator (https://github.com/FrunkQ/gondryator, The Unlicense), unchanged.
// Minimal tag readers: ID3v2 (MP3), FLAC Vorbis comments + picture, MP4/M4A ilst, Ogg Vorbis comments.
// Returns whatever it finds; the file name is the fallback title.

export interface Tags { title: string; artist: string; album: string; art: Blob | null; /** Release year, 0 if unknown. */ year: number }

export function readTags(buf: ArrayBuffer, fileName: string): Tags {
  const fallback = fileName.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');
  const out: Tags = { title: '', artist: '', album: '', art: null, year: 0 };
  const u8 = new Uint8Array(buf);
  try {
    if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) id3(u8, out);
    else if (u8[0] === 0x66 && u8[1] === 0x4c && u8[2] === 0x61 && u8[3] === 0x43) flac(u8, out);
    else if (str(u8, 4, 4) === 'ftyp') mp4(u8, out);
    else if (str(u8, 0, 4) === 'OggS') ogg(u8, out);
  } catch (e) {
    console.warn('tag parse failed', e);
  }
  if (!out.title) {
    // "Artist - Title" file names are common.
    const m = fallback.match(/^(.+?)\s+-\s+(.+)$/);
    if (m && !out.artist) { out.artist = m[1]; out.title = m[2]; } else out.title = fallback;
  }
  // No year tag: a year in the title, album or file name will do ("Song (1983 remaster)", "Hits of 1999").
  if (!out.year) out.year = yearIn(`${out.title} ${out.album} ${fallback}`);
  return out;
}

/** A plausible release year in a string, or 0. Original-release tags win over reissue dates. */
function yearIn(s: string): number {
  const m = s.match(/(?:^|\D)(19[2-9]\d|20[0-4]\d)(?!\d)/);
  return m ? Number(m[1]) : 0;
}
const setYear = (out: Tags, v: string, original = false) => { const y = yearIn(v); if (y && (original || !out.year)) out.year = y; };

function str(u8: Uint8Array, o: number, n: number) {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(u8[o + i]);
  return s;
}
const be32 = (u8: Uint8Array, o: number) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
const le32 = (u8: Uint8Array, o: number) => (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0;
const syncsafe = (u8: Uint8Array, o: number) => (u8[o] << 21) | (u8[o + 1] << 14) | (u8[o + 2] << 7) | u8[o + 3];

function decodeText(enc: number, bytes: Uint8Array): string {
  const label = enc === 1 ? 'utf-16' : enc === 2 ? 'utf-16be' : enc === 3 ? 'utf-8' : 'latin1';
  return new TextDecoder(label).decode(bytes).replace(/\0+$/, '').replace(/\0/g, ' / ').trim();
}

function id3(u8: Uint8Array, out: Tags) {
  const ver = u8[3];
  const size = syncsafe(u8, 6);
  let o = 10;
  if (u8[5] & 0x40) o += ver === 4 ? syncsafe(u8, 10) : be32(u8, 10) + 4;
  const end = Math.min(u8.length, 10 + size);
  while (o + 10 < end) {
    const id = str(u8, o, 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const fsize = ver === 4 ? syncsafe(u8, o + 4) : be32(u8, o + 4);
    const body = u8.subarray(o + 10, o + 10 + fsize);
    if (id === 'TIT2') out.title = decodeText(body[0], body.subarray(1));
    else if (id === 'TPE1') out.artist = decodeText(body[0], body.subarray(1));
    else if (id === 'TALB') out.album = decodeText(body[0], body.subarray(1));
    else if (id === 'TYER' || id === 'TDRC') setYear(out, decodeText(body[0], body.subarray(1)));
    else if (id === 'TORY' || id === 'TDOR') setYear(out, decodeText(body[0], body.subarray(1)), true);
    else if (id === 'APIC' && !out.art) {
      const enc = body[0];
      let p = 1;
      let mimeEnd = p;
      while (body[mimeEnd] !== 0) mimeEnd++;
      const mime = str(body, p, mimeEnd - p) || 'image/jpeg';
      p = mimeEnd + 1 + 1; // skip picture type
      if (enc === 1 || enc === 2) { while (!(body[p] === 0 && body[p + 1] === 0)) p += 2; p += 2; }
      else { while (body[p] !== 0) p++; p++; }
      out.art = new Blob([body.slice(p)], { type: mime.includes('/') ? mime : 'image/' + mime.toLowerCase() });
    }
    o += 10 + fsize;
  }
}

function vorbisComments(u8: Uint8Array, o: number, out: Tags) {
  const vlen = le32(u8, o); o += 4 + vlen;
  const n = le32(u8, o); o += 4;
  const dec = new TextDecoder();
  for (let i = 0; i < n && o < u8.length; i++) {
    const len = le32(u8, o); o += 4;
    const s = dec.decode(u8.subarray(o, o + len)); o += len;
    const eq = s.indexOf('=');
    const k = s.slice(0, eq).toUpperCase(), v = s.slice(eq + 1);
    if (k === 'TITLE') out.title = v;
    else if (k === 'ARTIST') out.artist = v;
    else if (k === 'ALBUM') out.album = v;
    else if (k === 'DATE' || k === 'YEAR') setYear(out, v);
    else if (k === 'ORIGINALDATE' || k === 'ORIGINALYEAR') setYear(out, v, true);
  }
}

function flacPicture(u8: Uint8Array, o: number, out: Tags) {
  o += 4;
  const mlen = be32(u8, o); o += 4;
  const mime = str(u8, o, mlen); o += mlen;
  const dlen = be32(u8, o); o += 4 + dlen + 16;
  const len = be32(u8, o); o += 4;
  out.art = new Blob([u8.slice(o, o + len)], { type: mime });
}

function flac(u8: Uint8Array, out: Tags) {
  let o = 4;
  while (o + 4 < u8.length) {
    const hdr = u8[o];
    const type = hdr & 0x7f;
    const len = (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3];
    if (type === 4) vorbisComments(u8, o + 4, out);
    if (type === 6 && !out.art) flacPicture(u8, o + 4, out);
    o += 4 + len;
    if (hdr & 0x80) break;
  }
}

function ogg(u8: Uint8Array, out: Tags) {
  // Find the comment header: "\x03vorbis" or "OpusTags".
  for (let i = 0; i < Math.min(u8.length - 8, 65536); i++) {
    if (u8[i] === 3 && str(u8, i + 1, 6) === 'vorbis') { vorbisComments(u8, i + 7, out); return; }
    if (str(u8, i, 8) === 'OpusTags') { vorbisComments(u8, i + 8, out); return; }
  }
}

function mp4(u8: Uint8Array, out: Tags) {
  const walk = (start: number, end: number, path: string) => {
    let o = start;
    while (o + 8 <= end) {
      let size = be32(u8, o);
      const type = str(u8, o + 4, 4);
      if (size === 1) size = Number(be32(u8, o + 12)); // 64-bit sizes: assume < 4 GB
      if (size < 8) break;
      const body = o + 8;
      if (type === 'moov' || type === 'udta' || type === 'ilst') walk(body, o + size, path + '/' + type);
      else if (type === 'meta') walk(body + 4, o + size, path + '/meta');
      else if (path.endsWith('ilst')) {
        // child atom with a 'data' atom inside
        const dataType = be32(u8, body + 8);
        const payload = u8.subarray(body + 16, o + size);
        const text = () => new TextDecoder().decode(payload);
        if (type === '©nam') out.title = text();
        else if (type === '©ART') out.artist = text();
        else if (type === '©alb') out.album = text();
        else if (type === '©day') setYear(out, text());
        else if (type === 'covr') out.art = new Blob([payload.slice()], { type: dataType === 14 ? 'image/png' : 'image/jpeg' });
      }
      o += size;
    }
  };
  walk(0, u8.length, '');
}
